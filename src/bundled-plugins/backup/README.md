# typeclaw-plugin-backup

The bundled backup plugin. Watches the agent folder for uncommitted work and commits + pushes it during quiet moments, with the LLM picking commit messages and diagnosing push/rebase failures. Replaces the previously documented-but-unimplemented "sessions/ via auto-backup" promise.

This plugin is **auto-loaded** by every TypeClaw agent. There is no `plugins[]` entry to add and no opt-out short of `backup.enabled: false`. To configure it, add a `backup` block to `typeclaw.json`.

## Config

```json
{
  "backup": {
    "enabled": true,
    "idleMs": 30000,
    "pushToOrigin": true
  }
}
```

| Field                     | Default | Effect                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup.enabled`          | `true`  | Master switch. When `false`, all hooks no-op and the runner subagent is never spawned.                                                                                                                                                                                                                                          |
| `backup.idleMs`           | `30000` | Debounce window after the agent goes idle (no in-flight prompt turns) before the backup runner fires. Resets on every new prompt. Minimum `1000`.                                                                                                                                                                               |
| `backup.pushToOrigin`     | `true`  | When `true`, after committing, the runner attempts `git push`. On non-fast-forward, it `git fetch && git rebase` then re-pushes. On rebase conflict, it aborts the rebase and asks the diagnose subagent to write a human-readable report. Set `false` to commit-only (useful for offline workflows or repos without a remote). |
| `backup.commitTimeoutMs`  | `30000` | Per-command wall clock for local git operations (status/add/commit/diff). Mostly an escape hatch — defaults are generous.                                                                                                                                                                                                       |
| `backup.networkTimeoutMs` | `60000` | Per-command wall clock for network git operations (push/fetch/rebase). Bounds the failure mode where a stuck remote would otherwise hang the runner indefinitely. `GIT_TERMINAL_PROMPT=0` is also set so auth failures fail fast instead of prompting.                                                                          |

All fields are **restart-required** — the plugin reads them once at boot.

## How it triggers

The backup plugin uses **`session.idle` with debounce** as its trigger, not a fixed cron schedule. This means backups fire only after meaningful agent activity has settled — sporadic agents that never go idle (e.g. long polling loops in tools) will not be backed up by this plugin alone.

The fire path is gated by an **active-turn counter**: the plugin tracks `session.turn.start` / `session.turn.end` events from every prompt source (TUI, channel router, cron consumer, subagent invocations) and only fires when the count is zero. The plugin's own three subagents (`backup`, `backup-message`, `backup-diagnose`) are excluded from the count via `origin.kind === 'subagent' && origin.subagent` matching, so the backup never self-gates.

If a new prompt arrives while the runner is in flight, the runner finishes its current commit-and-push cycle; the plugin then re-evaluates the gate. There is no preemption mid-commit — the unit of atomicity is one full backup pass.

## What it commits

The runner stages two categories of dirty paths:

- **Tracked or untracked agent paths** (anything `git status --porcelain=v1 --untracked-files=all` reports), **except** paths under `memory/` — those are owned by the memory plugin's dreaming subagent.
- **Force-added `sessions/`** — gitignored, but force-added so transcripts survive across restarts.

Commit message comes from the `backup-message` subagent, which sees a truncated `git status` and `git diff --cached --stat` and writes a single conventional-ish commit message to a tmp file. On any failure the runner falls back to `chore: backup`.

## What it pushes

When `pushToOrigin: true`, the runner picks a push plan after committing:

- **Branch has an upstream** (`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` succeeds): run `git push`.
- **No upstream, but `origin` exists and `HEAD` is a real branch**: run `git push -u origin HEAD:<branch>`, which pushes _and_ establishes tracking in one shot. This is the common case for a fresh agent folder nobody ran `git push -u` on by hand — previously the runner committed forever and never pushed here. Every later cycle then takes the plain-upstream path.
- **No `origin`, or detached `HEAD`**: commit only (a legitimate offline / no-remote state). No push is attempted and no diagnostics are written.

On non-fast-forward rejection (either push shape), the runner runs `git fetch` then `git rebase <remote-branch>` then re-pushes with the same args. Only `origin` is ever acted on for the set-upstream case — the runner never guesses a destination the operator didn't configure.

**Credentials.** The runner spawns `git` directly as a runtime-owned process, independently of model-driven bash. For **GitHub App auth** the backup plugin mints a per-repo installation token for `origin`'s github.com slug and injects it into the runner's git env through its runtime `/tmp` `GIT_ASKPASS` helper (token in `TYPECLAW_GIT_TOKEN`, never in argv/config; ssh remotes rewritten to https via `insteadOf`). Classic/fine-grained PATs, SSH-key, and credential-helper setups are left untouched — the runner uses its inherited process env. Non-github origins are never minted for.

If any network step fails (rebase conflict, auth failure, network timeout), the runner aborts cleanly and spawns the `backup-diagnose` subagent. That subagent has `bash`, `read`, and `write` tools and writes a short human-readable report to `<agentDir>/sessions/backup-diagnostics.log`. The diagnose subagent is explicitly forbidden from force-pushing or resolving merge conflicts itself.

## What it contributes

| Kind     | Name                          | Notes                                                                                                                                                       |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagent | `backup`                      | Runner orchestrator. No LLM call — `handler` directly invokes the deterministic `runBackup`. Coalesced per `agentDir`.                                      |
| Subagent | `backup-message`              | Picks commit message from the diff. Has only the `write` tool. Coalesced per `agentDir`.                                                                    |
| Subagent | `backup-diagnose`             | Diagnoses push/rebase failures. Has `bash`, `read`, `write`. Coalesced per `agentDir`.                                                                      |
| Hook     | `session.turn.start` / `.end` | Maintains the active-turn counter. Excludes self-induced turns (the three subagents above) so the backup never gates against itself.                        |
| Hook     | `session.idle`                | Debouncer (idleMs). Resets the timer on every event. On fire, checks the active-turn counter and spawns `backup` if zero.                                   |
| Hook     | `session.end`                 | Removes the session from the active-turn set on session close. Defensive: if a session ends mid-turn (network drop), `session.turn.end` may not have fired. |

## Files on disk

- **`<agentDir>/.typeclaw/backup-message.tmp`** — ephemeral. Written by `backup-message` subagent, read and then deleted by the runner. The directory is created on demand. Not gitignored because it always cleans itself up before commit.
- **`<agentDir>/sessions/backup-diagnostics.log`** — append-only log written by `backup-diagnose` when push/rebase fails. Lives under `sessions/` so it gets force-added by the next successful backup. Read this file when investigating why the backup plugin stopped working.

## Why this design

This feature came up as: "periodically check for dirty files and commit; LLM picks the message and handles failures." A pre-implementation Oracle review pushed back hard on two assumptions:

1. **Don't make the core flow LLM-driven.** A subagent with `bash` orchestrating push/rebase/conflict recovery can hang on auth prompts, freestyle-mishandle conflicts, or burn an LLM call on every backup even when nothing went wrong. Instead, the deterministic runner owns the flow and only delegates two narrow tasks to LLMs: commit message synthesis (one short call, naturally bounded) and failure diagnosis (only fires on actual failures).

2. **`session.start` / `session.end` is the wrong gate.** Long-lived TUI and channel sessions stay open for hours; counting open sessions would mean the backup never fires. The new `session.turn.start` / `session.turn.end` hooks bracket each `session.prompt(...)` call across all four call sites (TUI server, cron consumer, subagent runner, channel router), so the counter reflects "active work in progress" rather than "any session connected".

`session.idle` (with debounce) was chosen over cron because it ties backup frequency to actual activity. There is no fixed `*/15 * * * *` schedule to misconfigure or re-explain. The tradeoff is the sporadic-agent case noted above.

## Tests

- `runner.test.ts` — deterministic runner unit tests (status parsing, force-add of `sessions/`, push-with-upstream, push-and-set-upstream when origin exists but tracking is absent, commit-only on no-origin / detached-HEAD, rebase-on-non-fast-forward for both push shapes, diagnose-on-rebase-conflict, advisory-throw isolation, sanitize-commit-message).
- `git-auth.test.ts` — credential-env resolution (App-auth mints for the origin slug; PAT/SSH/non-github/unavailable-token all fall back to inherited env).
- `index.test.ts` — plugin composition tests (subagent/hook surface, config schema defaults and validation, debounce, active-turn gating, self-induced-turn exclusion, coalescing).
