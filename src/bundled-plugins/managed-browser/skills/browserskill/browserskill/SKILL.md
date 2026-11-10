---
name: browserskill
description: BrowserSkill (bsk) CLI driving the shared TypeClaw browser through its extension. Use for semantic page observation, table/list extraction, recording traces, and website debugging evidence.
---

# browserskill

The `bsk` CLI talks to a daemon TypeClaw runs next to the shared browser; the BrowserSkill extension is preloaded and connected. `bsk` reaches that daemon through `$TYPECLAW_BSK_RELAY`; do not set `BSK_HOME` yourself. If the variable is unset, this session's role cannot use the shared browser (it needs the `browser.shared` permission) or the browser failed to start; the operator log (`typeclaw logs`) names which. Do not try to start Chrome yourself.

```bash
bsk status --json                       # a connected browser must be listed
SID=$(bsk session start --agent-name TypeClaw --json | jq -r .session_id)
bsk navigate https://example.com/signup --session "$SID"   # the first navigation of the blank tab needs no context
SYNC=$(bsk cooperate sync --session "$SID" --json)
CTX=$(jq -r .context_id <<<"$SYNC"); OBS=$(jq -r .observation_id <<<"$SYNC")
bsk snapshot --session "$SID"           # @eN refs; use the ones your snapshot shows
bsk fill @e2 --value Alice --session "$SID" --context "$CTX"
bsk press Enter --ref @e2 --session "$SID" --context "$CTX"
bsk session stop "$SID"                 # always stop, success or failure
```

- Targeted page actions (`click`, `fill`, `select`, `press --ref`, `hover`, `scroll-to`, ...) need `--context` from `bsk cooperate sync`. One context covers reads and completed DOM actions until the document changes (a navigation, a form submit); then sync again and take fresh refs. Reads (`snapshot`, `get-html`, `screenshot`) need none.
- `navigate` (after the first one), `evaluate`, `wheel`, a `press` without `--ref`, and screenshot-coordinate clicks also need `--observation` with the top-level `observation_id` from a sync (not the nested `observation.observation_id`). Each observation is single-use: sync again before the next such action.
- `--expect '[{"target":"@e4","field":"text","equals":"Save"}]'` makes an action fail with `precondition_failed` instead of acting when the fact you decided on changed.
- A `permission_denied` refusal names why in `data.reason`: `control_context_invalid` (missing or stale `--context`), `observation_required` (add a fresh `--observation`), `cooperation_sync_required`. Each means sync, read the page again, and decide afresh; never replay the refused action blindly. If `effect_state` is `unknown`, check the page for the result before retrying.
- Redirect large output to a file (`bsk get-html --session "$SID" --json > /tmp/page.json`); piping it straight into another command can crash `bsk` with `failed printing to stdout`.
- Sessions open their own Agent Window. Never borrow an existing tab: borrowing asks a human to confirm, and nobody can click it here.
- `bsk --help` and `bsk <command> --help` list everything (`extract`, `observe`, `record`, `debug`).
- Never run `bsk update`, `bsk daemon stop`, or `bsk daemon restart`; TypeClaw owns the daemon and its version.

## Shared browser rules

- One TypeClaw-managed Chrome serves every engine and every session that has `browser.shared`. Logins and tabs persist across bash calls and sessions.
- Work only in tabs you opened. Never navigate or close a tab another engine or session is using.
- Files: Chrome's own downloads land in `$TYPECLAW_BROWSER_FILES`, and Chrome cannot see other paths. `bsk upload --file <path>` and `bsk download --out <path>` move files through the CLI, so they accept any path your bash can read or write.
- The browser runs in its own sandbox with no view of the agent folder, so `file://` URLs outside `$TYPECLAW_BROWSER_FILES` fail by design.
