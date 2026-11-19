---
name: browser-use
description: Browser Use CLI for driving the shared TypeClaw browser from Python snippets over CDP. Use for browsing, clicking, scraping and screenshots when you prefer Python helpers.
---

# browser-use

The `browser-use` CLI runs a Python snippet with browser helpers pre-imported. `$BU_CDP_WS` points it at the shared browser. If the variable is unset, this session's role cannot use the shared browser (it needs the `browser.shared` permission) or the browser failed to start; the operator log (`typeclaw logs`) names which. Do not try to start Chrome yourself.

```bash
browser-use <<'PY'
new_tab("https://example.com")
wait_for_load()
print(page_info())
PY
```

Run `browser-use skill` once to read the full helper reference (`ensure_real_tab`, `click_at_xy`, `cdp(...)`, screenshots). Its tabs are marked with a horse emoji in the title; keep to those.

Never run `browser-use --update`, `browser-use auth login`, or remote/cloud daemons (`start_remote_daemon`): the version is pinned by TypeClaw and cloud browsers are not part of this setup.

## Shared browser rules

- One TypeClaw-managed Chrome serves every engine and every session that has `browser.shared`. Logins persist across bash calls and sessions. Tabs your session opens persist across its bash calls and close when the session ends or after 15 minutes unused, so reopen the page in a later session instead of looking for an old tab.
- Work only in tabs you opened. Never navigate or close a tab another engine or session is using.
- Files: downloads land in `$TYPECLAW_BROWSER_FILES`; to upload a file, copy it there first and pass that path. Chrome cannot see other paths.
- The browser runs in its own sandbox with no view of the agent folder, so `file://` URLs outside `$TYPECLAW_BROWSER_FILES` fail by design.
